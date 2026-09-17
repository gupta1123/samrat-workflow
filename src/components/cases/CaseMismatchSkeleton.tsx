import { AppShell } from "@/components/dashboard/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import styles from "@/components/cases/CaseMismatchPage.module.css";

export function CaseMismatchSkeleton() {
  return (
    <AppShell>
      <div
        className={styles.redesignPage}
        aria-label="Loading mismatch review"
        aria-busy="true"
      >
        <header className={styles.redesignHeader}>
          <Skeleton className="h-3 w-52 bg-stone-100" />
          <div className={`${styles.redesignHeaderRow} py-1`}>
            <Skeleton className="h-7 w-36 bg-stone-100" />
            <Skeleton className="h-6 w-24 rounded-full bg-amber-50" />
            <div className={styles.redesignHeaderActions}>
              <Skeleton className="h-9 w-28 rounded-lg bg-stone-100" />
              <Skeleton className="h-9 w-28 rounded-lg bg-emerald-50" />
            </div>
          </div>
          <Skeleton className="my-2 h-3 w-[30rem] max-w-full bg-stone-100" />
        </header>
        <section className={styles.mismatchMetrics} aria-hidden="true">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index}>
              <Skeleton className="h-2.5 w-20 bg-stone-100" />
              <Skeleton className="mt-2 h-5 w-24 bg-stone-100" />
            </div>
          ))}
          <Skeleton className="ml-auto h-1.5 w-48 rounded-full bg-stone-100" />
          <Skeleton className="h-3 w-28 bg-stone-100" />
        </section>
        <main className={styles.mismatchList} aria-hidden="true">
          {Array.from({ length: 3 }).map((_, groupIndex) => (
            <section className={styles.mismatchGroup} key={groupIndex}>
              <div className={styles.mismatchGroupTitle}>
                <Skeleton className="h-3 w-36 bg-stone-100" />
                <i />
              </div>
              <div className={styles.mismatchGroupRows}>
                {Array.from({ length: groupIndex === 0 ? 3 : 2 }).map(
                  (__, rowIndex) => (
                    <div className={styles.mismatchRow} key={rowIndex}>
                      <Skeleton className="h-2.5 w-2.5 rounded-full bg-rose-100" />
                      <div className="space-y-2">
                        <Skeleton className="h-3.5 w-48 bg-stone-100" />
                        <Skeleton className="h-3 w-64 max-w-full bg-stone-100" />
                      </div>
                      <Skeleton className="ml-auto h-3 w-20 bg-stone-100" />
                      <Skeleton className="ml-auto h-3 w-24 bg-stone-100" />
                      <Skeleton className="h-4 w-4 bg-stone-100" />
                    </div>
                  ),
                )}
              </div>
            </section>
          ))}
        </main>
      </div>
    </AppShell>
  );
}
