import { useEffect, useRef, useState } from "react"

/**
 * Open while a decision is pending, folded once it lands — unless the reader
 * opened or shut the card by hand, in which case their choice wins.
 *
 * A decision card (question, plan) is mounted while pending and stays mounted
 * when the answer arrives (the poll fills in `result` on the same block), so
 * the fold has to react to that transition, not just to the initial state.
 * Otherwise a stack of decided cards pushes the live conversation off screen.
 */
export function useFoldOnDecision(pending: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(pending)
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current) setOpen(pending)
  }, [pending])
  const toggle = () => {
    touched.current = true
    setOpen((o) => !o)
  }
  return [open, toggle]
}
