import { motion, AnimatePresence } from "framer-motion";
import { ReactNode } from "react";

export function MotionStep({ active, children, className }: { active: boolean, children: ReactNode, className?: string }) {
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          transition={{ duration: 0.2 }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
