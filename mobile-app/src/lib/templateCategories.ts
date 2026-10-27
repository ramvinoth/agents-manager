/** Agent template categories: display label and identity tint. The templates
 *  themselves live on the server (viewer/db.py _BUILTIN_TEMPLATES, served by
 *  /api/agent-templates); the tint is a per-category identity (like an avatar
 *  seed), not a theme role, so it is the same in light and dark. */
export const TEMPLATE_CATEGORIES: Record<string, { label: string; color: string }> = {
  personal: { label: "Personal", color: "#6b8e6b" },
  engineering: { label: "Engineering", color: "#7a8eb5" },
  design: { label: "Design", color: "#b07aad" },
  business: { label: "Business", color: "#c2884a" },
}
