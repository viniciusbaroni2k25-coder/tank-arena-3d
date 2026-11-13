interface Env {
  LOBBY: DurableObjectNamespace;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const id = env.LOBBY.idFromName('tank-arena-global-lobby');
  return env.LOBBY.get(id).fetch(request);
};
