import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import styles from "./AppShell.module.css";

type AppShellProps = {
  children: React.ReactNode;
  defaultSidebarCollapsed?: boolean;
};

export function AppShell({
  children,
  defaultSidebarCollapsed = false,
}: AppShellProps) {
  return (
    <div className={styles.shell}>
      <DashboardSidebar defaultCollapsed={defaultSidebarCollapsed} />

      <main className={styles.main}>
        {process.env.NEXT_PUBLIC_DEMO_MODE === "true" && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-center text-xs text-amber-900">
            Local preview · sample data only · changes reset when the preview
            restarts
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
