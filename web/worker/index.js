// Cloudflare Worker in front of the app.
//
// Some Indian internet providers block *.supabase.co, so the browser never talks
// to Supabase directly: it calls /supabase/... on this site and the Worker
// forwards the request to the project. Everything else is the React app.
// Only the Supabase APIs the app uses are forwarded, and only to our project.
const ALLOWED = ['/auth/v1/', '/rest/v1/', '/functions/v1/', '/storage/v1/']

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/supabase/')) return env.ASSETS.fetch(request)

    const path = url.pathname.slice('/supabase'.length)
    if (!ALLOWED.some((p) => path.startsWith(p))) return new Response('Not found', { status: 404 })

    const target = new URL(path + url.search, env.SUPABASE_URL)
    const headers = new Headers(request.headers)
    for (const h of ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']) {
      headers.delete(h)
    }
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    return fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    })
  },
}
