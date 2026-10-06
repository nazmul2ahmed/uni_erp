import { SaleInvoice } from "@/components/sale/sale-ui";
export default function SaleInvoicePage({ params }: { params: { id: string } }) { return <SaleInvoice id={params.id} />; }