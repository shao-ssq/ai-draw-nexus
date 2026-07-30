import { useNavigate, useLocation } from 'react-router-dom'
import { NAV_ITEMS } from '@/constants'

interface AppSidebarProps {
  onCreateProject?: () => void
}

export function AppSidebar({ onCreateProject }: AppSidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <aside className="fixed left-4 top-1/2 z-40 flex -translate-y-1/2 flex-col items-center rounded-2xl border border-border bg-surface p-2 shadow-lg">
      {/* Navigation Items */}
      <nav className="flex flex-col items-center gap-1">
        {NAV_ITEMS.map((item, index) => (
          <button
            key={index}
            onClick={() => navigate(item.path)}
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
              location.pathname === item.path
                ? 'bg-background text-primary'
                : 'text-muted hover:bg-background hover:text-primary'
            }`}
            title={item.label}
          >
            <item.icon className="h-5 w-5" />
          </button>
        ))}
      </nav>
    </aside>
  )
}
