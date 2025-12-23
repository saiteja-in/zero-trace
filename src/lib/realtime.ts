import { redis } from "@/lib/redis"
import { InferRealtimeEvents, Realtime } from "@upstash/realtime"
import z from "zod"

const message = z.object({
  id: z.string(),
  sender: z.string(),
  text: z.string(),
  timestamp: z.number(),
  roomId: z.string(),
  token: z.string().optional(),
  isEdited: z.boolean().optional(),
  editedAt: z.number().optional(),
  isDeleted: z.boolean().optional(),
  deletedAt: z.number().optional(),
})

const schema = {
  chat: {
    message,
    destroy: z.object({
      isDestroyed: z.literal(true),
    }),
    "message.edit": message,
    "message.delete": z.object({
      messageId: z.string(),
      roomId: z.string(),
    }),
  },
}

export const realtime = new Realtime({ schema, redis })
export type RealtimeEvents = InferRealtimeEvents<typeof realtime>
export type Message = z.infer<typeof message>