import { redis } from "@/lib/redis";
import { Elysia } from "elysia";
import { nanoid } from "nanoid";
import { authMiddleware } from "./auth";
import z from "zod";
import { Message, realtime } from "@/lib/realtime";

// Base TTL for a room in seconds.
// We implement "sliding" expiration: activity (sending a message) extends the room lifetime.
const ROOM_TTL_SECONDS = 60 * 10;
const rooms = new Elysia({ prefix: "/room" })
  .post("/create", async () => {
    const roomId = nanoid();

    // Initialize room metadata and TTL in a single round trip.
    const pipeline = redis.pipeline();
    pipeline.hset(`meta:${roomId}`, {
      connected: [],
      createdAt: Date.now(),
    });
    pipeline.expire(`meta:${roomId}`, ROOM_TTL_SECONDS);
    await pipeline.exec();

    return { roomId };
  })
  .use(authMiddleware)
  .get(
    "/ttl",
    async ({ auth }) => {
      const ttl = await redis.ttl(`meta:${auth.roomId}`);
      return { ttl: ttl > 0 ? ttl : 0 };
    },
    { query: z.object({ roomId: z.string() }) }
  )
  .delete(
    "/",
    async ({ auth }) => {
      const { roomId } = auth;

      await realtime
        .channel(roomId)
        .emit("chat.destroy", { isDestroyed: true });

      // Clean up all room-related keys in a single pipeline.
      const pipeline = redis.pipeline();
      pipeline.del(roomId);
      pipeline.del(`meta:${roomId}`);
      pipeline.del(`messages:${roomId}`);
      await pipeline.exec();
    },
    { query: z.object({ roomId: z.string() }) }
  );
const messages = new Elysia({ prefix: "/messages" })
  .use(authMiddleware)
  .post(
    "/",
    async ({ body, auth, set }) => {
      const { sender, text } = body;
      const { roomId } = auth;

      // Ensure the room still exists.
      const roomExists = await redis.exists(`meta:${roomId}`);
      if (!roomExists) {
        set.status = 410; // Gone
        throw new Error("Room does not exist");
      }

      // Simple per-token rate limiting to prevent abuse.
      const rateKey = `rate:${auth.token}`;
      const currentCount = await redis.incr(rateKey);
      if (currentCount === 1) {
        // First message in this window: set window to 5 seconds.
        await redis.expire(rateKey, 5);
      }
      // Allow up to 20 messages per 5-second window.
      if (currentCount > 20) {
        set.status = 429;
        throw new Error("Rate limit exceeded");
      }

      const message: Message = {
        id: nanoid(),
        sender,
        text,
        timestamp: Date.now(),
        roomId,
      };

      // Add message and keep TTLs in sync using a pipeline.
      const ttl = await redis.ttl(`meta:${roomId}`);

      const pipeline = redis.pipeline();
      pipeline.rpush(`messages:${roomId}`, {
        ...message,
        token: auth.token,
      });

      // If metadata TTL is missing/expired, re-establish it based on our base TTL.
      const newTtl = ttl > 0 ? Math.min(ttl + 5, ROOM_TTL_SECONDS) : ROOM_TTL_SECONDS;
      pipeline.expire(`meta:${roomId}`, newTtl);
      pipeline.expire(`messages:${roomId}`, newTtl);
      pipeline.expire(roomId, newTtl);

      await pipeline.exec();

      await realtime.channel(roomId).emit("chat.message", message);
    },
    {
      query: z.object({ roomId: z.string() }),
      body: z.object({
        sender: z.string().max(100),
        text: z.string().max(1000),
      }),
    }
  )
  .get(
    "/",
    async ({ auth }) => {
      const messages = await redis.lrange<Message>(
        `messages:${auth.roomId}`,
        0,
        -1
      );
      return {
        messages: messages.map((m) => ({
          ...m,
          token: m.token === auth.token ? auth.token : undefined,
        })),
      };
    },
    { query: z.object({ roomId: z.string() }) }
  )
  .patch(
    "/:messageId",
    async ({ params, body, auth, set }) => {
      const { messageId } = params;
      const { text } = body;
      const { roomId, token } = auth;

      // Ensure the room still exists.
      const roomExists = await redis.exists(`meta:${roomId}`);
      if (!roomExists) {
        set.status = 410; // Gone
        throw new Error("Room does not exist");
      }

      // Get all messages and find the one to edit.
      const messages = await redis.lrange<Message>(
        `messages:${roomId}`,
        0,
        -1
      );
      
      const messageIndex = messages.findIndex((m) => m.id === messageId);
      if (messageIndex === -1) {
        set.status = 404;
        throw new Error("Message not found");
      }

      const message = messages[messageIndex];
      
      // Verify ownership via token.
      if (message.token !== token) {
        set.status = 403;
        throw new Error("Not authorized to edit this message");
      }

      // Update the message.
      const updatedMessage: Message = {
        ...message,
        text,
        isEdited: true,
        editedAt: Date.now(),
      };

      // Replace the message in the list.
      await redis.lset(`messages:${roomId}`, messageIndex, updatedMessage);

      // Emit realtime event.
      await (realtime.channel(roomId) as any).emit("chat.message.edit", updatedMessage);

      return { success: true };
    },
    {
      query: z.object({ roomId: z.string() }),
      params: z.object({ messageId: z.string() }),
      body: z.object({
        text: z.string().max(1000),
      }),
    }
  )
  .delete(
    "/:messageId",
    async ({ params, auth, set }) => {
      const { messageId } = params;
      const { roomId, token } = auth;

      // Ensure the room still exists.
      const roomExists = await redis.exists(`meta:${roomId}`);
      if (!roomExists) {
        set.status = 410; // Gone
        throw new Error("Room does not exist");
      }

      // Get all messages and find the one to delete.
      const messages = await redis.lrange<Message>(
        `messages:${roomId}`,
        0,
        -1
      );
      
      const messageIndex = messages.findIndex((m) => m.id === messageId);
      if (messageIndex === -1) {
        set.status = 404;
        throw new Error("Message not found");
      }

      const message = messages[messageIndex];
      
      // Verify ownership via token.
      if (message.token !== token) {
        set.status = 403;
        throw new Error("Not authorized to delete this message");
      }

      // Soft delete: mark as deleted but keep in list.
      const deletedMessage: Message = {
        ...message,
        isDeleted: true,
        deletedAt: Date.now(),
        text: "", // Clear text content
      };

      // Update the message in the list.
      await redis.lset(`messages:${roomId}`, messageIndex, deletedMessage);

      // Emit realtime event.
      await (realtime.channel(roomId) as any).emit("chat.message.delete", {
        messageId,
        roomId,
      });

      return { success: true };
    },
    {
      query: z.object({ roomId: z.string() }),
      params: z.object({ messageId: z.string() }),
    }
  );

export const app = new Elysia({ prefix: "/api" }).use(rooms).use(messages);

export const GET = app.fetch;
export const POST = app.fetch;
export const DELETE= app.fetch
export const PATCH = app.fetch;
