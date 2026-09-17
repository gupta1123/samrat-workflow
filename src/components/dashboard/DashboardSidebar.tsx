"use client";

import {
  ChevronLeft,
  FileStack,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Settings,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import styles from "./DashboardSidebar.module.css";

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
    items: [
      { href: "/recycle-bin", label: "Recycle Bin", icon: Trash2 },
      { href: "/settings", label: "Review settings", icon: Settings },
    ],
  },
];
export function DashboardSidebar({
  defaultCollapsed = false,
}: {
  defaultCollapsed?: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
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
          {sections.flatMap((section) => section.items).map(navItem)}
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
      <form
        method="post"
        action="/auth/signout"
        className={`${styles.userRowWrapper} p-3`}
      >
        <button
          type="submit"
          aria-label="Sign out"
          title={collapsed ? "Sign out" : undefined}
          className={`${styles.navItem} w-full`}
        >
          <span className={styles.navItemLeft}>
            <LogOut className={styles.navIcon} />
            <span className={styles.navTitle}>Sign out</span>
          </span>
        </button>
      </form>
    </aside>
  );
}
