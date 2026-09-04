"use client";
import { useParams } from "next/navigation";
import { EntityDetail } from "@/components/business/business-ui";
export default function CustomerDetailPage() { const params = useParams<{ id: string }>(); return <div className="page-content"><EntityDetail kind="customer" id={params.id} /></div>; }