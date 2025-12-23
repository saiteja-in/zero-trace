"use client";
import { useUsername } from "@/hooks/use-username";
import { client } from "@/lib/eden";
import { useRealtime } from "@/lib/realtime-client";
import { Message } from "@/lib/realtime";
import { useMutation, useQuery } from "@tanstack/react-query";
import {format} from "date-fns"
import { useParams, useRouter } from "next/navigation";
import React, { useEffect, useRef, useState } from "react";

function formatTimeRemaining(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const Page = () => {
  const params = useParams();
  const roomId = params.roomId as string;
  const router=useRouter()
  const { username } = useUsername();

  const [copyStatus, setCopyStatus] = useState("COPY");
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null)

  const { data: ttlData } = useQuery({
    queryKey: ["ttl", roomId],
    queryFn: async () => {
      const res = await client.room.ttl.get({ query: { roomId } })
      return res.data
    },
  })
  useEffect(() => {
    if (ttlData?.ttl !== undefined) setTimeRemaining(ttlData.ttl)
  }, [ttlData])

  useEffect(() => {
    if (timeRemaining === null || timeRemaining < 0) return

    if (timeRemaining === 0) {
      router.push("/?destroyed=true")
      return
    }

    const interval = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [timeRemaining, router])

  const {data:messages,refetch}=useQuery({
    queryKey:["messages",roomId],
    queryFn:async()=>{
      const res=await client.messages.get({
        query:{roomId}
      })
      if(res.status!==200){
        throw new Error("Failed to load messages")
      }
      return res.data
    }
  })

  const { mutate: sendMessage, isPending } = useMutation({
    mutationFn: async ({ text }: { text: string }) => {
      const res = await client.messages.post(
        {
          sender: username,
          text,
        },
        { query: { roomId } }
      );
      if(res.status===410){
        // Room expired
        router.push("/?destroyed=true")
        throw new Error("Room has expired")
      }
      if(res.status===429){
        throw new Error("Rate limit exceeded. Please slow down.")
      }
      if(res.status!==200){
        throw new Error("Failed to send message")
      }
      setInput("")
    },
    onMutate: async ({ text }) => {
      // Cancel outgoing refetches
      await refetch();
      
      // Snapshot previous value
      const previousMessages = messages;
      
      // Optimistically update UI
      if (previousMessages) {
        const optimisticMessage = {
          id: `temp-${Date.now()}`,
          sender: username,
          text,
          timestamp: Date.now(),
          roomId,
          token: undefined,
        };
        
        // Update query cache optimistically
        // Note: We'll let the realtime event handle the actual update
      }
      
      return { previousMessages };
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousMessages) {
        // Query will refetch automatically, but we can set error state
        setError(error instanceof Error ? error.message : "Failed to send message");
      }
    },
    onSuccess: () => {
      setError(null);
    },
  });

  useRealtime({
    channels: [roomId],
    events: ["chat.message", "chat.destroy", "chat.message.edit", "chat.message.delete"],
    onData: ({ event }) => {
      if (event === "chat.message") {
        refetch()
      }

      if (event === "chat.destroy") {
        router.push("/?destroyed=true")
      }

      if (event === "chat.message.edit" || event === "chat.message.delete") {
        refetch()
      }
    },
  });

  const { mutate: destroyRoom } = useMutation({
    mutationFn: async () => {
      await client.room.delete(null, { query: { roomId } })
    },
  })

  const [input, setInput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const copyLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url);
    setCopyStatus("COPIED");
    setTimeout(() => setCopyStatus("COPY"), 1500);
  };

  const handleSendMessage = () => {
    if (!input.trim()) return;
    setError(null);
    sendMessage({ text: input });
  };

  const { mutate: editMessage } = useMutation({
    mutationFn: async ({ messageId, text }: { messageId: string; text: string }) => {
      const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
      const res = await fetch(`${BASE_URL}/api/messages/${messageId}?roomId=${roomId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        if (res.status === 410) {
          router.push("/?destroyed=true");
          throw new Error("Room has expired");
        }
        throw new Error("Failed to edit message");
      }
      setEditingMessageId(null);
      setEditText("");
    },
    onError: (error) => {
      setError(error instanceof Error ? error.message : "Failed to edit message");
    },
  });

  const { mutate: deleteMessage } = useMutation({
    mutationFn: async ({ messageId }: { messageId: string }) => {
      const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
      const res = await fetch(`${BASE_URL}/api/messages/${messageId}?roomId=${roomId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 410) {
          router.push("/?destroyed=true");
          throw new Error("Room has expired");
        }
        throw new Error("Failed to delete message");
      }
    },
    onError: (error) => {
      setError(error instanceof Error ? error.message : "Failed to delete message");
    },
  });

  const handleStartEdit = (message: Message) => {
    setEditingMessageId(message.id);
    setEditText(message.text);
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditText("");
  };

  const handleSaveEdit = () => {
    if (!editText.trim() || !editingMessageId) return;
    editMessage({ messageId: editingMessageId, text: editText });
  };

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.messages]);
  return (
    <main className="flex flex-col h-screen max-h-screen overflow-hidden">
      <header className="border-b border-zinc-800 p-4 flex items-center justify-between bg-zinc-900/30">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="text-xs text-zinc-500 uppercase">Room Id</span>
            <div className="flex items-center gap-2">
              <span className="font-bold text-green-500">{roomId}</span>
              <button
                onClick={() => copyLink()}
                className="text-[10px] bg-zinc-800 hover:bg-zinc-700 px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                {copyStatus}
              </button>
            </div>
          </div>
          <div className="h-8 w-px bg-zinc-800" />
          <div className="flex flex-col">
            <span className="text-xs text-zinc-500 uppercase">
              self-destruct
            </span>
            <span
              className={`text-sm font-bold flex items-center gap-2 ${
                timeRemaining !== null && timeRemaining < 60
                  ? "text-red-500"
                  : "text-amber-500"
              }`}
            >
              {timeRemaining !== null
                ? formatTimeRemaining(timeRemaining)
                : "--:--"}
            </span>
          </div>
        </div>
        <button onClick={() => destroyRoom()} className="text-xs bg-zinc-800 hover:bg-red-600 px-3 py-1.5 rounded text-zinc-400 hover:text-white font-bold transition-all group flex items-center gap-2 disabled:opacity-50 uppercase">
          <span className="group-hover:animate-pulse">☠️</span>
          destroy now
        </button>
      </header>
      {/* messages go here */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
        {messages?.messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-zinc-600 text-sm font-mono">
              No messages yet, start the conversation.
            </p>
          </div>
        )}

        {messages?.messages.map((msg) => {
          const isOwnMessage = msg.sender === username;
          const isEditing = editingMessageId === msg.id;
          const isDeleted = msg.isDeleted;

          return (
            <div key={msg.id} className="flex flex-col items-start">
              <div className="max-w-[80%] group relative">
                <div className="flex items-baseline gap-3 mb-1">
                  <span
                    className={`text-xs font-bold ${
                      isOwnMessage ? "text-green-500" : "text-blue-500"
                    }`}
                  >
                    {isOwnMessage ? "YOU" : msg.sender}
                  </span>

                  <span className="text-[10px] text-zinc-600">
                    {format(msg.timestamp, "HH:mm")}
                  </span>

                  {msg.isEdited && (
                    <span className="text-[10px] text-zinc-500 italic">
                      (edited)
                    </span>
                  )}

                  {isOwnMessage && !isDeleted && !isEditing && (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleStartEdit(msg)}
                        className="text-[10px] bg-zinc-800 hover:bg-zinc-700 px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
                        title="Edit message"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={() => deleteMessage({ messageId: msg.id })}
                        className="text-[10px] bg-zinc-800 hover:bg-red-600 px-2 py-0.5 rounded text-zinc-400 hover:text-white transition-colors"
                        title="Delete message"
                      >
                        🗑️
                      </button>
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleSaveEdit();
                        } else if (e.key === "Escape") {
                          handleCancelEdit();
                        }
                      }}
                      className="w-full bg-black border border-zinc-700 focus:border-zinc-600 focus:outline-none text-zinc-100 py-2 px-3 text-sm rounded"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleSaveEdit}
                        className="text-xs bg-green-600 hover:bg-green-700 px-3 py-1 rounded text-white font-bold transition-colors"
                      >
                        Save
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="text-xs bg-zinc-800 hover:bg-zinc-700 px-3 py-1 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : isDeleted ? (
                  <p className="text-sm text-zinc-600 italic leading-relaxed">
                    Message deleted
                  </p>
                ) : (
                  <p className="text-sm text-zinc-300 leading-relaxed break-all">
                    {msg.text}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
      <div className="p-4 border-t border-zinc-800 bg-zinc-900/30">
        {error && (
          <div className="mb-2 bg-red-950/50 border border-red-900 p-2 text-center">
            <p className="text-red-500 text-xs">{error}</p>
          </div>
        )}
        <div className="flex gap-4">
          <div className="flex-1 relative group">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-green-500 animate-pulse">
              {">"}
            </span>
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={input}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim() && !isPending) {
                  handleSendMessage();
                }
              }}
              placeholder="Type message..."
              onChange={(e) => {
                setInput(e.target.value);
                setError(null);
              }}
              className="w-full bg-black border border-zinc-800 focus:border-zinc-700 focus:outline-none transition-colors text-zinc-100 placeholder:text-zinc-700 py-3 pl-8 pr-4 text-sm"
            />
          </div>
          <button
            onClick={handleSendMessage}
            disabled={!input.trim() || isPending}
            className="bg-zinc-800 text-zinc-400 px-6 text-sm font-bold hover:text-zinc-200 transition-all disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          >
            {isPending ? "SENDING..." : "SEND"}
          </button>
        </div>
      </div>
    </main>
  );
};

export default Page;
