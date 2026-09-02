import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { MemoryService, ReconciliationEntry } from "../memory/memory.service.js";
import { PERSONA_NAME } from "../persona/persona.data.js";
import { ExtractedFactInput } from "../../common/types.js";
import { Logger } from "../../common/logger.js";

/**
 * This graph deliberately covers only the extract -> reconcile half of a turn.
 * Retrieval and reply generation live in ChatService as plain sequential calls instead of
 * graph nodes, because reply generation needs to stream tokens to the client as they arrive —
 * LangGraph's node model returns a state update once a node finishes, which doesn't fit
 * token-level streaming naturally. The extract/reconcile half has no such requirement and does
 * have a genuine conditional branch (skip classification when nothing exists to reconcile
 * against), which is exactly what a graph is good for.
 */
export const ChatState = Annotation.Root({
  userMessage: Annotation<string>,
  reply: Annotation<string>,
  sourceMessageId: Annotation<string | undefined>,
  extractedUserFacts: Annotation<ExtractedFactInput[]>({ default: () => [], reducer: (_p, n) => n }),
  extractedPersonaFacts: Annotation<ExtractedFactInput[]>({ default: () => [], reducer: (_p, n) => n }),
  hasCandidates: Annotation<boolean>({ default: () => false, reducer: (_p, n) => n }),
  reconciliation: Annotation<ReconciliationEntry[]>({ default: () => [], reducer: (_p, n) => n }),
});

export type ChatStateType = typeof ChatState.State;

export class ChatGraphNodes {
  private readonly logger = new Logger("ChatGraph");

  constructor(private readonly userMemory: MemoryService, private readonly personaMemory: MemoryService) {}

  extractFacts = async (state: ChatStateType): Promise<Partial<ChatStateType>> => {
    const turnText = `User: ${state.userMessage}\n${PERSONA_NAME}: ${state.reply}`;
    const [extractedUserFacts, extractedPersonaFacts] = await Promise.all([
      this.userMemory.extractFacts(turnText, "user"),
      this.personaMemory.extractFacts(turnText, "companion"),
    ]);
    const [userHasCandidates, personaHasCandidates] = await Promise.all([
      this.userMemory.anyHaveCandidates(extractedUserFacts),
      this.personaMemory.anyHaveCandidates(extractedPersonaFacts),
    ]);
    return {
      extractedUserFacts,
      extractedPersonaFacts,
      hasCandidates: userHasCandidates || personaHasCandidates,
    };
  };

  routeAfterExtract = (state: ChatStateType): "reconcile" | "insert" => {
    return state.hasCandidates ? "reconcile" : "insert";
  };

  reconcileWithClassification = async (state: ChatStateType): Promise<Partial<ChatStateType>> => {
    const [userRecon, personaRecon] = await Promise.all([
      this.userMemory.reconcileAll(state.extractedUserFacts, state.sourceMessageId),
      this.personaMemory.reconcileAll(state.extractedPersonaFacts, state.sourceMessageId),
    ]);
    return { reconciliation: [...userRecon, ...personaRecon] };
  };

  insertFactsDirectly = async (state: ChatStateType): Promise<Partial<ChatStateType>> => {
    const [userRecon, personaRecon] = await Promise.all([
      this.userMemory.insertAllDirectly(state.extractedUserFacts, state.sourceMessageId),
      this.personaMemory.insertAllDirectly(state.extractedPersonaFacts, state.sourceMessageId),
    ]);
    return { reconciliation: [...userRecon, ...personaRecon] };
  };
}

export function buildChatGraph(nodes: ChatGraphNodes) {
  const graph = new StateGraph(ChatState)
    .addNode("extractFacts", nodes.extractFacts)
    .addNode("reconcileWithClassification", nodes.reconcileWithClassification)
    .addNode("insertFactsDirectly", nodes.insertFactsDirectly)
    .addEdge(START, "extractFacts")
    .addConditionalEdges("extractFacts", nodes.routeAfterExtract, {
      reconcile: "reconcileWithClassification",
      insert: "insertFactsDirectly",
    })
    .addEdge("reconcileWithClassification", END)
    .addEdge("insertFactsDirectly", END);

  return graph.compile();
}
