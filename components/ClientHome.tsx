"use client";

import dynamic from "next/dynamic";

const PdfReviewer = dynamic(() => import("@/components/PdfReviewer"), {
  ssr: false,
});

export default function ClientHome() {
  return (
    <main className="flex flex-1 flex-col p-4 md:p-6">
      <PdfReviewer />
    </main>
  );
}
