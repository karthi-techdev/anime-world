"use client";

import { CharacterViewer } from "@/components/CharacterViewer";

export default function Home() {
  return (
    <main className="w-screen h-screen overflow-hidden bg-zinc-950">
      <CharacterViewer />
    </main>
  );
}
