import { SaleDetail } from "@/components/sale/sale-ui";
export default function SalePage({ params }: { params: { id: string } }) { return <SaleDetail id={params.id} />; }