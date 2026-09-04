"use client";
import { useParams } from "next/navigation";
import { EntityForm } from "@/components/business/business-ui";
export default function EditCustomerPage() { const params = useParams<{ id: string }>(); return <div className="page-content"><EntityForm kind="customer" id={params.id} /></div>; }