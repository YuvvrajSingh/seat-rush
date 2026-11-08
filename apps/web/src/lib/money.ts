const wholeRupees = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const rupeesAndPaise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

/** Formats integer paise as rupees: "₹200", or "₹200.50" when there are paise to show. */
export function formatPaise(paise: number): string {
  return paise % 100 === 0 ? wholeRupees.format(paise / 100) : rupeesAndPaise.format(paise / 100);
}
