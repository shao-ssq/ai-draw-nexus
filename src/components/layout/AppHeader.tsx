export function AppHeader() {
  return (
    <header className="flex items-center justify-between px-8 py-4">
      <div className="flex items-center gap-2">
        <img src="/logo.png" alt="WeDraw" className="h-8 w-8 rounded-lg object-contain" />
        <span className="text-lg font-semibold text-primary">WeDraw</span>
      </div>

    </header>
  )
}
