import type { Metadata } from "next";
import { Literata } from "next/font/google";
import { notFound } from "next/navigation";

import { PrintToolbar } from "@/components/public/print-toolbar";
import { MarkdownArticle } from "@/components/shared/markdown-article";
import { isAdminAuthenticated } from "@/lib/auth";
import { isValidPrintToken } from "@/lib/pdf";
import { findPlayIdByRef, getAdminPlayById } from "@/lib/plays";

import "./print.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const literata = Literata({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-print-serif",
});

type PrintPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ actor?: string; t?: string }>;
};

/** "Mariana (Ana)" -> { person: "Mariana", role: "Ana" } */
function splitActorName(name: string) {
  const match = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  return match ? { person: match[1]!, role: match[2]! } : { person: name, role: "" };
}

/** "Permanecer — Obra de Navidad" -> ["Permanecer", "Obra de Navidad"] */
function splitTitle(title: string) {
  const [main, ...rest] = title.split(/\s+[—–-]\s+/);
  return { main: main || title, subtitle: rest.join(" — ") };
}

function cssString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r<>]/g, " ")}"`;
}

export default async function PrintPage({ params, searchParams }: PrintPageProps) {
  const { slug } = await params;
  const { actor: actorParam, t } = await searchParams;
  const playId = await findPlayIdByRef(slug);
  const play = playId ? await getAdminPlayById(playId) : null;

  if (!play) {
    notFound();
  }

  const isPublic = play.published && !play.hidden;
  if (!isPublic && !isValidPrintToken(play.id, t) && !(await isAdminAuthenticated())) {
    notFound();
  }

  const actor = play.actors.find((candidate) => candidate.id === actorParam) ?? null;
  const actorLines = actor ? play.assignments.filter((a) => a.actorIds.includes(actor.id)).length : 0;
  const { main, subtitle } = splitTitle(play.title);
  // Cast in order of first appearance in the script.
  const firstAppearance = (actorId: string) =>
    Math.min(...play.assignments.filter((a) => a.actorIds.includes(actorId)).map((a) => a.startOffset), Number.MAX_SAFE_INTEGER);
  const cast = [...play.actors]
    .sort((left, right) => firstAppearance(left.id) - firstAppearance(right.id))
    .map((candidate) => ({ id: candidate.id, ...splitActorName(candidate.name) }));
  const actorParts = actor ? splitActorName(actor.name) : null;
  const generatedOn = new Intl.DateTimeFormat("es-CO", { dateStyle: "long", timeZone: "America/Bogota" }).format(new Date());
  const runningTitle = actorParts ? `${main} · ${actorParts.role || actorParts.person}` : main;

  return (
    <div className={`printDoc ${literata.variable}`}>
      <style>{`
        @page {
          size: A4;
          margin: 18mm 18mm 20mm;
          @bottom-left { content: ${cssString(runningTitle)}; font: 8.5pt var(--font-geist-sans), Arial, sans-serif; color: #8a7f74; letter-spacing: 0.04em; }
          @bottom-right { content: counter(page) " / " counter(pages); font: 8.5pt var(--font-geist-sans), Arial, sans-serif; color: #8a7f74; }
        }
        @page :first {
          @bottom-left { content: none; }
          @bottom-right { content: none; }
        }
      `}</style>

      <PrintToolbar
        slug={play.slug}
        actors={play.actors}
        selectedActorId={actor?.id ?? ""}
        isPublic={isPublic}
      />

      <section className="printCover">
        <div className="printCoverInner">
          <p className="printEyebrow">Guion de teatro</p>
          <h1 className="printTitle">{main}</h1>
          {subtitle ? <p className="printSubtitle">{subtitle}</p> : null}

          <div className="printRule" aria-hidden="true">
            <span />
            <i>✦</i>
            <span />
          </div>

          {actorParts ? (
            <div className="printFor">
              <p className="printForLabel">Ejemplar de</p>
              <p className="printForName">{actorParts.person}</p>
              {actorParts.role ? <p className="printForRole">en el papel de {actorParts.role}</p> : null}
              <p className="printLegend">
                <mark className="actor-highlight">Tus partes</mark> están resaltadas y marcadas en el margen
                {actorLines ? ` · ${actorLines} fragmentos` : ""}.
              </p>
            </div>
          ) : null}

          {cast.length ? (
            <div className="printCast">
              <p className="printCastTitle">Reparto</p>
              <ul>
                {cast.map((member) => (
                  <li key={member.id} className={member.id === actor?.id ? "isMe" : undefined}>
                    <span className="printCastRole">{member.role || member.person}</span>
                    <span className="printCastDots" aria-hidden="true" />
                    <span className="printCastPerson">{member.role ? member.person : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <p className="printCoverFooter">obras.orientador.co · {generatedOn}</p>
      </section>

      <main className="printBody">
        <MarkdownArticle
          markdown={play.markdown}
          assignments={play.assignments}
          activeActorId={actor?.id ?? ""}
          actors={play.actors}
          enableVoting={false}
          printMode
        />
        <p className="printEnd" aria-hidden="true">✦</p>
      </main>
    </div>
  );
}
