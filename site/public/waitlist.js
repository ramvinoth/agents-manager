const form = document.getElementById("waitlist")
const status = form.querySelector(".status")

form.addEventListener("submit", async (e) => {
  e.preventDefault()
  const button = form.querySelector("button")
  button.disabled = true
  status.textContent = ""
  try {
    const res = await fetch(form.action, { method: "POST", body: new FormData(form) })
    if (!res.ok) throw new Error(String(res.status))
    form.reset()
    status.textContent = "You are on the list. We will write when your invite is ready."
  } catch {
    status.textContent = "That did not go through. Please try again in a minute."
    button.disabled = false
  }
})
