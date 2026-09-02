import mongoose from "mongoose";
import { env } from "./env.js";
import { Logger } from "../common/logger.js";

const logger = new Logger("Database");

export class Database {
  private static connected = false;

  static async connect(): Promise<void> {
    if (Database.connected) return;
    await mongoose.connect(env.mongoUri);
    Database.connected = true;
    logger.info(`Connected to MongoDB at ${env.mongoUri}`);
  }

  static async disconnect(): Promise<void> {
    if (!Database.connected) return;
    await mongoose.disconnect();
    Database.connected = false;
  }
}
