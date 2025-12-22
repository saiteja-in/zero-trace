// import { treaty } from '@elysiajs/eden'
// import { app } from '../app/api/[[...slugs]]/route'

// // .api to enter /api prefix
// export const client =
//   typeof process !== 'undefined'
//     ? treaty(app).api
//     : treaty<typeof app>('localhost:3000').api


import { treaty } from "@elysiajs/eden";
import { app } from "../app/api/[[...slugs]]/route";

const BASE_URL =
  (typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_API_URL
    : process.env.API_URL) ?? "http://localhost:3000";

// `.api` adds the `/api` prefix defined in the Elysia app.
export const client =
  typeof window === "undefined"
    ? treaty(app).api        // server: in-memory calls
    : treaty<typeof app>(BASE_URL).api;  // browser: real HTTP requests 