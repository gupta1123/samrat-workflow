"use client";

import {
  ChevronLeft,
  ChevronsUpDown,
  FileStack,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Settings,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { PopoverClose } from "@radix-ui/react-popover";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import styles from "./DashboardSidebar.module.css";

const settingsItem = {
  href: "/settings",
  label: "Review settings",
  icon: Settings,
};

const sections = [
  {
    title: "Main",
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    title: "Cases",
    items: [
      { href: "/workspace", label: "Add Case", icon: FileStack },
      { href: "/cases", label: "All Cases", icon: FolderOpen },
    ],
  },
  {
    title: "System",
    items: [{ href: "/recycle-bin", label: "Recycle Bin", icon: Trash2 }],
  },
];
type SidebarUser = { name: string; email: string };

// Kept for the page lifetime so navigating between pages does not flash an empty user row.
let cachedSidebarUser: SidebarUser | null = null;

function nameFromEmail(email: string) {
  const local = email.split("@")[0] || "User";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials =
    parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return initials.toUpperCase();
}

function useSidebarUser() {
  const [user, setUser] = useState<SidebarUser | null>(cachedSidebarUser);

  useEffect(() => {
    if (cachedSidebarUser) return;
    let active = true;
    try {
      // getSession reads the saved session locally; it makes no backend request.
      void createSupabaseBrowserClient()
        .auth.getSession()
        .then(({ data: { session } }) => {
          const email = session?.user?.email;
          if (!active || !email) return;
          const metadata = session.user.user_metadata ?? {};
          const metadataName =
            typeof metadata.full_name === "string"
              ? metadata.full_name
              : typeof metadata.name === "string"
                ? metadata.name
                : "";
          cachedSidebarUser = {
            name: metadataName.trim() || nameFromEmail(email),
            email,
          };
          setUser(cachedSidebarUser);
        })
        .catch(() => {});
    } catch {
      // Missing browser configuration only hides the user details.
    }
    return () => {
      active = false;
    };
  }, []);

  return user;
}

export function DashboardSidebar({
  defaultCollapsed = false,
}: {
  defaultCollapsed?: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const user = useSidebarUser();
  const displayName = user?.name ?? "Account";
  const navItem = ({
    href,
    label,
    icon: Icon,
  }: (typeof sections)[number]["items"][number]) => {
    const active =
      href === "/"
        ? pathname === href
        : pathname === href || pathname.startsWith(`${href}/`);
    return (
      <li key={href}>
        <Link
          href={href}
          aria-label={label}
          title={collapsed ? label : undefined}
          aria-current={active ? "page" : undefined}
          className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
        >
          <div className={styles.navItemLeft}>
            {active && <div className={styles.activeBar} />}
            <Icon className={styles.navIcon} />
            <span className={styles.navTitle}>{label}</span>
          </div>
        </Link>
      </li>
    );
  };
  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}>
      <div
        className={`${styles.brandRow} ${collapsed ? styles.collapsed : ""}`}
      >
        <Link
          href="/"
          aria-label="Samrat Group dashboard"
          className={styles.brandLeft}
        >
          <span className={styles.brandLogoMark}>S</span>
          <span className={styles.brandTitle}>Samrat Group</span>
        </Link>
        <button
          className={styles.collapseBtn}
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronLeft className={`h-4 w-4 ${collapsed ? "rotate-180" : ""}`} />
        </button>
      </div>
      <nav
        aria-label="Main navigation"
        className={`${styles.navSection} ${styles.desktopNav}`}
      >
        {sections.map((section) => (
          <div key={section.title} className={styles.sectionGroup}>
            {!collapsed && (
              <h3 className={styles.sectionHeader}>{section.title}</h3>
            )}
            <ul className={styles.navList}>{section.items.map(navItem)}</ul>
          </div>
        ))}
      </nav>
      <nav
        aria-label="Mobile navigation"
        className={`${styles.navSection} ${styles.mobileNav}`}
      >
        <ul className={styles.navList}>
          {/* Phones have no account popover, so settings stays in the bottom bar. */}
          {[...sections.flatMap((section) => section.items), settingsItem].map(
            navItem,
          )}
          <li className={styles.mobileLogoutItem}>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className={`${styles.navItem} ${styles.mobileLogoutButton}`}
              >
                <span className={styles.navItemLeft}>
                  <LogOut className={styles.navIcon} />
                  <span className={styles.navTitle}>Sign out</span>
                </span>
              </button>
            </form>
          </li>
        </ul>
      </nav>
      <div className={styles.spacer} />
      <div className={`${styles.userRowWrapper} p-2`}>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              title={collapsed ? displayName : undefined}
              className={`${styles.userRow} ${collapsed ? styles.userRowCollapsed : ""}`}
            >
              <span className={styles.userAvatar}>
                {getInitials(displayName)}
              </span>
              {!collapsed && (
                <>
                  <span className={styles.userText}>
                    <span className={styles.userName}>{displayName}</span>
                    {user?.email && (
                      <span className={styles.userEmail}>{user.email}</span>
                    )}
                  </span>
                  <ChevronsUpDown className={styles.userChevron} />
                </>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side={collapsed ? "right" : "top"}
            align={collapsed ? "end" : "start"}
            sideOffset={8}
            className="w-[var(--radix-popover-trigger-width)] min-w-56 rounded-xl border-[#e5ddd0] bg-white p-1.5 shadow-lg"
          >
            {user?.email && (
              <div className="border-b border-[#efe9e1] px-2.5 pb-2 pt-1.5">
                <div className="truncate text-sm font-medium text-[#1f2937]">
                  {displayName}
                </div>
                <div className="truncate text-xs text-[#8a8174]">
                  {user.email}
                </div>
              </div>
            )}
            <div className="border-b border-[#efe9e1] py-1">
              <PopoverClose asChild>
                <Link
                  href={settingsItem.href}
                  aria-current={
                    pathname.startsWith(settingsItem.href) ? "page" : undefined
                  }
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition hover:bg-[#f4efe8] ${pathname.startsWith(settingsItem.href) ? "bg-[#f1ebe2] text-[#1f1b17]" : "text-[#3f3a34]"}`}
                >
                  <Settings className="h-4 w-4" />
                  {settingsItem.label}
                </Link>
              </PopoverClose>
            </div>
            <form method="post" action="/auth/signout" className="pt-1">
              <button
                type="submit"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[#9f3a2f] transition hover:bg-rose-50"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </button>
            </form>
          </PopoverContent>
        </Popover>
      </div>
    </aside>
  );
}
