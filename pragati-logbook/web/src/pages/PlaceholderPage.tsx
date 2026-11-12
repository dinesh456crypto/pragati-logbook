export function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="card">
      <h1>{title}</h1>
      <p className="muted">This screen is built in the next phase, from the requirements document.</p>
    </section>
  )
}
