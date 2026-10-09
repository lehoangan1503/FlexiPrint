/**
 * Page components. The host mounts them with one-line route files:
 *
 *   src/app/customize-tool/page.tsx        → export { CustomizeListPage as default }
 *   src/app/customize-tool/[id]/page.tsx   → export { CustomizeEditorPage as default }
 *   src/app/products/[id]/deploy/page.tsx  → export { CustomizeDeployPage as default }
 *
 * Kept outside src/app so the whole module moves as one folder.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { CT_CONFIG } from "../config";
import { ctSession } from "../server/supabase";
import { CustomizeProductList } from "../components/product-list";
import { CustomizeEditor } from "../components/editor/editor";
import { DeployPage } from "../components/deploy/deploy-page";
import { LibraryManager } from "../components/library/library-manager";
import { CharList } from "../components/char/char-list";
import { CharProjectView } from "../components/char/char-project";

export async function CustomizeListPage() {
  const session = await ctSession();
  if (!session) redirect(CT_CONFIG.loginPath);
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link href={CT_CONFIG.homePath} className="rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-lg font-semibold">Customize Tool</h1>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <CustomizeProductList currentUserId={session.user.id} />
      </main>
    </div>
  );
}

export async function CustomizeEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await ctSession();
  if (!session) redirect(CT_CONFIG.loginPath);
  const { id } = await params;
  return <CustomizeEditor productId={id} />;
}

export async function CustomizeDeployPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await ctSession();
  if (!session) redirect(CT_CONFIG.loginPath);
  const { id } = await params;
  return <DeployPage productId={id} />;
}

/** Khuôn in: now a tab of the library (one place for clipart, artwork, phôi, khuôn). */
export async function CustomizePrintTemplatesPage() {
  const session = await ctSession();
  if (!session) redirect(CT_CONFIG.loginPath);
  return <LibraryManager initialTab="khuon" />;
}

export async function CustomizeLibraryPage() {
  const session = await ctSession();
  if (!session) redirect(CT_CONFIG.loginPath);
  return <LibraryManager />;
}

export async function CharListPage() {
  const session = await ctSession();
  if (!session) redirect(CT_CONFIG.loginPath);
  return <CharList currentUserId={session.user.id} />;
}

export async function CharProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await ctSession();
  if (!session) redirect(CT_CONFIG.loginPath);
  const { id } = await params;
  return <CharProjectView projectId={id} currentUserId={session.user.id} />;
}
