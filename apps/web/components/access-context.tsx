"use client";

import { createContext, useContext } from "react";

/**
 * What the signed-in user may do in the ACTIVE workspace, as reported by
 * GET /api/auth/me. Display hints only -- the server enforces every action
 * (13 s3.3). `permissions === null` means unknown (loading, signed out, or
 * no active workspace) and must be treated as "no access" for display.
 */
export interface Access {
  ready: boolean;
  permissions: string[] | null;
}

const AccessContext = createContext<Access>({ ready: false, permissions: null });

export const AccessProvider = AccessContext.Provider;
export const useAccess = (): Access => useContext(AccessContext);
