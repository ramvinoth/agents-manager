import { Search, ChevronUp, ChevronDown, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useStore } from "@/store"

export function SearchBar() {
  const open = useStore((s) => s.searchOpen)
  const query = useStore((s) => s.searchQuery)
  const matches = useStore((s) => s.searchMatches)
  const index = useStore((s) => s.searchIndex)
  const setQuery = useStore((s) => s.setSearchQuery)
  const nav = useStore((s) => s.searchNav)
  const close = useStore((s) => s.closeSearch)

  if (!open) return null
  return (
    <div className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-md backdrop-blur">
      <Search className="ml-1 size-3.5 text-muted-foreground" />
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") nav(e.shiftKey ? -1 : 1)
          if (e.key === "Escape") close()
        }}
        placeholder="Search transcript"
        className="h-7 w-56 border-0 shadow-none focus-visible:ring-0"
      />
      <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
        {matches.length ? `${index + 1}/${matches.length}` : "0"}
      </span>
      <Button size="icon" variant="ghost" className="size-6" onClick={() => nav(-1)} aria-label="Previous match">
        <ChevronUp className="size-3.5" />
      </Button>
      <Button size="icon" variant="ghost" className="size-6" onClick={() => nav(1)} aria-label="Next match">
        <ChevronDown className="size-3.5" />
      </Button>
      <Button size="icon" variant="ghost" className="size-6" onClick={close} aria-label="Close search">
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
