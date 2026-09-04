import { PurchaseDetail } from "@/components/purchase/purchase-ui";
export default function PurchaseDetailPage({ params }: { params: { id: string } }) { return <PurchaseDetail id={params.id} />; }