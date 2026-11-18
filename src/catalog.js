export const PLAN_DATA = [
  ["Market Starter", 3, "market-starter", false],
  ["Stock Explorer", 5, "stock-explorer", false],
  ["Equity Builder", 10, "equity-builder", false],
  ["Dividend Plus", 20, "dividend-plus", false],
  ["Bull Momentum", 30, "bull-momentum", false],
  ["Blue Chip", 50, "blue-chip", true],
  ["Market Leader", 80, "market-leader", true],
  ["Capital Prime", 100, "capital-prime", true],
  ["Exchange Elite", 200, "exchange-elite", true],
  ["Platinum Portfolio", 500, "platinum-portfolio", true],
].map(([name, price, image, locked], i) => {
  const priceInCents = Math.round(price * 100),
    daily = Math.round(priceInCents * 0.1),
    duration = 60;
  return {
  code: `SX${String(i + 1).padStart(2, "0")}`,
  name,
  price: priceInCents,
  daily,
  total: daily * duration,
  duration,
  locked,
  catalogVersion: 2,
  image: `/images/${image}.webp`,
  description:
    "60 scheduled daily payouts. Your initial investment is recovered through the first 10 scheduled payouts.",
  };
});
export const RANK_DATA = [
  ["Market Starter", 1000, 10000, 500, "Sprout"],
  ["Equity Associate", 2500, 25000, 800, "BriefcaseBusiness"],
  ["Portfolio Builder", 5000, 50000, 1000, "Layers"],
  ["Capital Specialist", 8000, 80000, 1500, "ChartNoAxesCombined"],
  ["Investment Strategist", 12000, 120000, 2000, "Compass"],
  ["Senior Strategist", 18000, 180000, 2500, "Award"],
  ["Portfolio Director", 25000, 250000, 3000, "Building2"],
  ["Capital Executive", 32000, 320000, 3500, "ShieldCheck"],
  ["Market Principal", 40000, 400000, 4000, "Gem"],
  ["Exchange Elite", 50000, 500000, 5000, "Crown"],
].map(([name, personal, team, reward, icon], i) => ({
  level: i + 1,
  name,
  personal: personal * 100,
  team: team * 100,
  reward: reward * 100,
  icon,
}));
// Pakistan wallets and banks available for member withdrawal requests.
export const INSTITUTIONS = [
  ["easypaisa", "Easypaisa", "EP"],
  ["jazzcash", "JazzCash", "JC"],
  ["sadapay", "SadaPay", "SP"],
  ["nayapay", "NayaPay", "NP"],
  ["zindigi", "Zindigi", "Z"],
  ["hblkonnect", "HBL Konnect", "HK"],
  ["keenu", "Keenu Wallet", "K"],
  ["digikhata", "DigiKhata", "DK"],
  ["finja", "OPay (Finja)", "OP"],
  ["digitt", "Digitt+", "D+"],
  ["onezapp", "OneZapp", "OZ"],
  ["hbl", "Habib Bank Limited", "HBL"],
  ["ubl", "United Bank Limited", "UBL"],
  ["alfalah", "Bank Alfalah Limited", "BAF"],
  ["samba", "Samba Bank Limited", "SB"],
  ["makramah", "Bank Makramah Limited", "BML"],
  ["mcb", "MCB Bank", "MCB"],
  ["meezan", "Meezan Bank Limited", "MB"],
  ["allied", "Allied Bank Limited", "ABL"],
  ["bankalhabib", "Bank AL Habib Limited", "BAH"],
  ["askari", "Askari Bank Limited", "AK"],
  ["faysal", "Faysal Bank Limited", "FB"],
  ["standardchartered", "Standard Chartered Bank Pakistan", "SC"],
  ["nbp", "National Bank of Pakistan", "NBP"],
  ["bop", "The Bank of Punjab", "BOP"],
  ["bok", "The Bank of Khyber", "BOK"],
  ["soneri", "Soneri Bank Limited", "SB"],
  ["js", "JS Bank Limited", "JS"],
  ["habibmetro", "Habib Metropolitan Bank Limited", "HM"],
  ["dubaiislamic", "Dubai Islamic Bank Pakistan", "DIB"],
  ["albaraka", "Al Baraka Bank Pakistan", "AB"],
  ["bankislami", "BankIslami Pakistan", "BI"],
  ["mcbislamic", "MCB Islamic Bank", "MIB"],
  ["firstwomen", "First Women Bank Limited", "FW"],
  ["ztbl", "Zarai Taraqiati Bank Limited", "ZTBL"],
  ["ppcb", "Punjab Provincial Cooperative Bank", "PPCB"],
  ["citi", "Citibank Pakistan", "CITI"],
  ["deutsche", "Deutsche Bank Pakistan", "DB"],
  ["icbc", "Industrial and Commercial Bank of China", "ICBC"],
  ["mashreq", "Mashreq Bank Pakistan", "MQ"],
  ["raqami", "Raqami Islamic Digital Bank", "RQ"],
  ["other", "Other bank or wallet", "BW"],
].map(([id, name, monogram]) => ({ id, name, monogram }));
export function payoutForDay(p, day) {
  return day === p.duration ? p.total - p.daily * (p.duration - 1) : p.daily;
}
export const DAY = 86400000;
export const PKR_PER_USD = 280;
export const pkrToUsdCents = (pkrCents) =>
  Math.floor(pkrCents / PKR_PER_USD);
