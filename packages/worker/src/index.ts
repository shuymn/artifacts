/** The artifacts Worker. It has no routes yet: every request is answered 404. */
export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
