import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TOTAL_SEATS } from "@seatrush/shared";
import { ImageResponse } from "next/og";

export const alt = `SeatRush: one empty cinema seat in a dark auditorium, beside the line "1,000 customers. ${TOTAL_SEATS} seats. Every seat sold once."`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Satori needs TTF/OTF, not the WOFF2 next/font serves, so the display face is vendored (OFL, see assets/fonts).
// It decodes PNG and JPEG but not WebP, so the cover is kept as a JPEG cropped to the output size.
const [display, cover] = await Promise.all([
  readFile(join(process.cwd(), "assets/fonts/BigShoulders-ExtraBold.ttf")),
  readFile(join(process.cwd(), "assets/social-cover.jpg")),
]);
const coverSrc = `data:image/jpeg;base64,${cover.toString("base64")}`;

/** Social preview: the generated chair photograph on the right, the title set on the calm left half. */
export default function OpengraphImage() {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", backgroundColor: "#1a0f22", position: "relative" }}>
      <img
        src={coverSrc}
        alt=""
        width={size.width}
        height={size.height}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          width: 600,
          height: "100%",
          paddingLeft: 80,
          fontFamily: "Big Shoulders",
          color: "#ece5f3",
        }}
      >
        <div style={{ fontSize: 148, lineHeight: 0.9, letterSpacing: -3 }}>SeatRush</div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 28, fontSize: 48, lineHeight: 1.05, color: "#b3a6c2" }}>
          <span>1,000 customers.</span>
          <span>{TOTAL_SEATS} seats.</span>
          <span>Every seat sold once.</span>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [{ name: "Big Shoulders", data: display, style: "normal", weight: 800 }],
    },
  );
}
