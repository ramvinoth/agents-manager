import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CardDetail } from "@/components/kanban/CardDetail"
import { api } from "@/lib/api"
import { userError } from "@/lib/errors"
import type { BoardColumn, Card } from "@/lib/types"

/** Opens a card by id from anywhere a card is mentioned (agent replies, inbox
 *  messages), so the owner never searches the board. Absent outside a
 *  provider, where card links stay inert. */
const CardLinkContext = createContext<((id: number) => void) | null>(null)
export const useCardLinkOpener = () => useContext(CardLinkContext)

type Shown = { card: Card; columns: BoardColumn[] } | { id: number; error: string }

/** Fetches the card only when a link is clicked, then shows its page over
 *  whatever is open. Mounted once at the app root. */
export function CardLinkProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null)
  const open = useCallback(async (id: number) => {
    try {
      const r = await api.orgCard(id)
      setShown({ card: r.card, columns: r.columns || [] })
    } catch (e) {
      setShown({ id, error: userError(e, `card ${id}`) })
    }
  }, [])
  return (
    <CardLinkContext.Provider value={open}>
      {children}
      {shown && "card" in shown && (
        <CardDetail
          card={shown.card}
          allCards={[]}
          columns={shown.columns}
          onChange={(u) => setShown((s) => s && "card" in s ? { ...s, card: u } : s)}
          onClose={() => setShown(null)}
        />
      )}
      {shown && "error" in shown && (
        <Dialog open onOpenChange={(o) => !o && setShown(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Can't open card {shown.id}</DialogTitle>
              <DialogDescription>{shown.error}</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      )}
    </CardLinkContext.Provider>
  )
}
