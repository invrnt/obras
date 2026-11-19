"use client";

import { useRouter } from "next/navigation";

import type { ActorSummary } from "@/lib/types";

type PrintToolbarProps = {
  slug: string;
  actors: ActorSummary[];
  selectedActorId: string;
  isPublic: boolean;
};

export function PrintToolbar({ slug, actors, selectedActorId, isPublic }: PrintToolbarProps) {
  const router = useRouter();
  const query = selectedActorId ? `?actor=${encodeURIComponent(selectedActorId)}` : "";

  return (
    <div className="printToolbar">
      <a className="printToolbarBack" href={isPublic ? `/obras/${slug}` : "/tramoya/panel"}>
        ← Volver
      </a>

      <label className="printToolbarField">
        <span>Resaltar</span>
        <select
          value={selectedActorId}
          onChange={(event) => {
            const value = event.target.value;
            router.replace(`/obras/${slug}/imprimir${value ? `?actor=${encodeURIComponent(value)}` : ""}`);
          }}
        >
          <option value="">Guion completo (sin resaltar)</option>
          {actors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name}
            </option>
          ))}
        </select>
      </label>

      <div className="printToolbarActions">
        <button type="button" className="printToolbarButton ghost" onClick={() => window.print()}>
          Imprimir
        </button>
        <a className="printToolbarButton" href={`/obras/${slug}/pdf${query}`}>
          Descargar PDF
        </a>
      </div>
    </div>
  );
}
