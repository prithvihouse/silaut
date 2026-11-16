const {Pool}=require('pg');
(async()=>{const p=new Pool();try{
 await p.query('GRANT USAGE ON SCHEMA public TO pos_app');
 await p.query(`GRANT SELECT ON menu_items,ingredients,recipe_ingredients,orders,order_items,menu_modifier_ingredients,
   restaurant_profile,restaurant_logos,ticket_stations,inventory_movements,shifts TO pos_app`);
 await p.query('GRANT INSERT ON orders,order_items,restaurant_logos,ticket_stations,inventory_movements,shifts TO pos_app');
 await p.query('GRANT UPDATE(on_hand,revision,unit_cost_millicents) ON ingredients TO pos_app');
 await p.query('GRANT UPDATE(stock_version_after,sellable_units_after,total_cents,receipt,status,status_updated_at,ready_at) ON orders TO pos_app');
 await p.query('GRANT UPDATE(name,location_label,address,logo_digest,cutoff_minutes) ON restaurant_profile TO pos_app');
 await p.query('GRANT UPDATE(status,status_updated_at,preparing_at,ready_at) ON ticket_stations TO pos_app');
 await p.query('GRANT UPDATE(closed_at,report) ON shifts TO pos_app');
 await p.query('GRANT USAGE,SELECT ON SEQUENCE orders_ticket_no_seq,inventory_movements_id_seq TO pos_app');
 console.log('Applied runtime role grants.');
}finally{await p.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
