import { type HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-line bg-surface p-6 shadow-[0_12px_32px_rgb(21_28_39_/_0.06)]",
        className,
      )}
      {...props}
    />
  );
}
