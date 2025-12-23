import { proxy } from "./src/proxy";
import { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  return proxy(req);
}

export const config = {
  matcher: "/room/:path*",
};

