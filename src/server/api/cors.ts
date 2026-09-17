import { NextResponse } from "next/server";

// Frontend and API are served from the same Netlify site. No cross-origin access.
export function applyCorsHeaders(response: NextResponse, _request: Request) {
  void _request;
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
export function jsonWithCors(
  request: Request,
  body: unknown,
  init?: ResponseInit,
) {
  return applyCorsHeaders(NextResponse.json(body, init), request);
}
export function optionsWithCors(request: Request) {
  return applyCorsHeaders(new NextResponse(null, { status: 204 }), request);
}
