/** Sajikan wallet-tester.html di http://localhost:8787 — MetaMask hanya menyuntik ke origin http(s), bukan file://. */
const html = Bun.file(new URL('./wallet-tester.html', import.meta.url))
Bun.serve({ port: 8787, hostname: '127.0.0.1', fetch: () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
console.log('🧪 wallet tester: http://localhost:8787')
