"use client";
import { useParams } from "next/navigation";
import { EntityDetail } from "@/components/business/business-ui";
export default function SupplierDetailPage() { const params = useParams<{ id: string }>(); return <div className="page-content"><EntityDetail kind="supplier" id={params.id} /></div>; }