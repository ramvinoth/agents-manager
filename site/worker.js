// Waitlist endpoint for the public site. The intake token stays here as a secret;
// the page only ever posts to /api/waitlist. Everything else is static assets.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== "/api/waitlist") return env.ASSETS.fetch(request)
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })

    const form = await request.formData()
    if (form.get("company")) return new Response(null, { status: 204 }) // honeypot: bots fill it
    const email = String(form.get("email") || "").trim().slice(0, 200)
    if (!EMAIL.test(email)) return new Response("Invalid email", { status: 400 })
    const use = String(form.get("use") || "").trim().slice(0, 300)

    const res = await fetch(env.INTAKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.INTAKE_TOKEN}` },
      body: JSON.stringify({ title: `Waitlist: ${email}`, text: use ? `Wants it for: ${use}` : "", from: email, key: email.toLowerCase() }),
    })
    return new Response(null, { status: res.ok ? 204 : 502 })
  },
}
