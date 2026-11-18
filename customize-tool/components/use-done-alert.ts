"use client";

import { useEffect, useRef } from "react";
import { aiDone } from "../lib/done-alert";

/** A screen that follows a running AI job: when `running` turns false, the done alert (lib/done-alert: hidden tab only). */
export function useDoneAlert(running: boolean): void {
  const was = useRef(running);
  useEffect(() => {
    if (was.current && !running) aiDone(true);
    was.current = running;
  }, [running]);
}
