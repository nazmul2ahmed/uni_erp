"use client";
import { useParams } from "next/navigation";
import { EntityForm } from "@/components/business/business-ui";
export default function EditSupplierPage() { const params = useParams<{ id: string }>(); return <div className="page-content"><EntityForm kind="supplier" id={params.id} /></div>; }