ALTER TABLE "core"."purchase_items" ADD COLUMN "order_discount_allocation" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."return_lines" ADD COLUMN "tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."returns" ADD COLUMN "tax_total" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."sale_items" ADD COLUMN "order_discount_allocation" numeric(18, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
WITH RECURSIVE line_amounts AS (
  SELECT
    si.id,
    si.sale_id,
    GREATEST(s.discount_total - SUM(si.line_discount) OVER (PARTITION BY si.sale_id), 0)::numeric(18, 4) AS order_discount,
    (si.quantity * si.unit_price - si.line_discount)::numeric(18, 4) AS allocation_weight,
    SUM(si.quantity * si.unit_price - si.line_discount) OVER (PARTITION BY si.sale_id)::numeric(18, 4) AS total_weight,
    ROW_NUMBER() OVER (PARTITION BY si.sale_id ORDER BY si.created_at, si.id) AS line_no,
    COUNT(*) OVER (PARTITION BY si.sale_id) AS row_count,
    si.created_at
  FROM core.sale_items si
  JOIN core.sales s ON s.id = si.sale_id
),
allocated AS (
  SELECT
    id,
    sale_id,
    line_no,
    row_count,
    CASE
      WHEN allocation_weight = 0 THEN 0
      WHEN allocation_weight = total_weight THEN order_discount
      WHEN total_weight > 0 THEN TRUNC(order_discount * allocation_weight / total_weight, 4)
      ELSE 0
    END AS allocation,
    order_discount - CASE
      WHEN allocation_weight = 0 THEN 0
      WHEN allocation_weight = total_weight THEN order_discount
      WHEN total_weight > 0 THEN TRUNC(order_discount * allocation_weight / total_weight, 4)
      ELSE 0
    END AS remaining_amount,
    total_weight - allocation_weight AS remaining_weight
  FROM line_amounts
  WHERE line_no = 1
  UNION ALL
  SELECT
    next_line.id,
    next_line.sale_id,
    next_line.line_no,
    next_line.row_count,
    next_allocation.allocation,
    allocated.remaining_amount - next_allocation.allocation,
    allocated.remaining_weight - next_line.allocation_weight
  FROM allocated
  JOIN line_amounts next_line
    ON next_line.sale_id = allocated.sale_id
   AND next_line.line_no = allocated.line_no + 1
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN next_line.allocation_weight = 0 THEN 0
      WHEN next_line.allocation_weight = allocated.remaining_weight THEN allocated.remaining_amount
      WHEN allocated.remaining_weight > 0 THEN TRUNC(allocated.remaining_amount * next_line.allocation_weight / allocated.remaining_weight, 4)
      ELSE 0
    END AS allocation
  ) next_allocation
)
UPDATE core.sale_items si
SET order_discount_allocation = allocated.allocation
FROM allocated
WHERE allocated.id = si.id;
--> statement-breakpoint
WITH RECURSIVE line_amounts AS (
  SELECT
    pi.id,
    pi.purchase_id,
    GREATEST(p.discount_total - SUM(pi.line_discount) OVER (PARTITION BY pi.purchase_id), 0)::numeric(18, 4) AS order_discount,
    (pi.quantity * pi.cost_price - pi.line_discount)::numeric(18, 4) AS allocation_weight,
    SUM(pi.quantity * pi.cost_price - pi.line_discount) OVER (PARTITION BY pi.purchase_id)::numeric(18, 4) AS total_weight,
    ROW_NUMBER() OVER (PARTITION BY pi.purchase_id ORDER BY pi.created_at, pi.id) AS line_no,
    COUNT(*) OVER (PARTITION BY pi.purchase_id) AS row_count,
    pi.created_at
  FROM core.purchase_items pi
  JOIN core.purchases p ON p.id = pi.purchase_id
),
allocated AS (
  SELECT
    id,
    purchase_id,
    line_no,
    row_count,
    CASE
      WHEN allocation_weight = 0 THEN 0
      WHEN allocation_weight = total_weight THEN order_discount
      WHEN total_weight > 0 THEN TRUNC(order_discount * allocation_weight / total_weight, 4)
      ELSE 0
    END AS allocation,
    order_discount - CASE
      WHEN allocation_weight = 0 THEN 0
      WHEN allocation_weight = total_weight THEN order_discount
      WHEN total_weight > 0 THEN TRUNC(order_discount * allocation_weight / total_weight, 4)
      ELSE 0
    END AS remaining_amount,
    total_weight - allocation_weight AS remaining_weight
  FROM line_amounts
  WHERE line_no = 1
  UNION ALL
  SELECT
    next_line.id,
    next_line.purchase_id,
    next_line.line_no,
    next_line.row_count,
    next_allocation.allocation,
    allocated.remaining_amount - next_allocation.allocation,
    allocated.remaining_weight - next_line.allocation_weight
  FROM allocated
  JOIN line_amounts next_line
    ON next_line.purchase_id = allocated.purchase_id
   AND next_line.line_no = allocated.line_no + 1
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN next_line.allocation_weight = 0 THEN 0
      WHEN next_line.allocation_weight = allocated.remaining_weight THEN allocated.remaining_amount
      WHEN allocated.remaining_weight > 0 THEN TRUNC(allocated.remaining_amount * next_line.allocation_weight / allocated.remaining_weight, 4)
      ELSE 0
    END AS allocation
  ) next_allocation
)
UPDATE core.purchase_items pi
SET order_discount_allocation = allocated.allocation
FROM allocated
WHERE allocated.id = pi.id;