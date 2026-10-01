/** The copy-id action: one `sidebar.workspaces.session.menu.item` row. */
import { IconCopyOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Menu row (order 500, with a hairline above it): copy the Session's id to
 * the system clipboard. The row identity is all the action needs; the slot's
 * shared open-state hook dismisses the menu.
 * @param props - owner share and the menu open state.
 * @returns the row.
 */
export function CopySessionIdMenuItem({ sessionId, useMenuOpenState, t }: SessionMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconCopyOutlineRegular size={14} />}
      separatorBefore
      onSelect={() => {
        setMenuOpen(false)
        void navigator.clipboard.writeText(sessionId)
      }}
    >
      {t('menu.copySessionId')}
    </MenuItemButton>
  )
}
