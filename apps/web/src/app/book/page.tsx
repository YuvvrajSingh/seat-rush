import type { Metadata } from "next";
import { BookingScreen } from "../../components/booking/booking-screen.js";

export const metadata: Metadata = {
  title: "Book seats",
  description: "Choose up to four seats for the SeatRush demo screening and hold them for five minutes.",
};

export default function BookPage() {
  return <BookingScreen />;
}
