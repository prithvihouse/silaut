import React from 'react';

export function Stone({small=false}){return <svg className={small?'stone small':'stone'} viewBox="0 0 48 48" aria-hidden="true"><path d="M7 30c0-8 7-13 17-14 10-1 17 5 17 13 0 6-8 10-18 10S7 36 7 30Z" fill="currentColor"/><rect x="15" y="11" width="25" height="7" rx="3.5" transform="rotate(-20 15 11)" fill="currentColor" opacity=".5"/></svg>}
export function MenuArt({category}){
 const variants={Burgers:2,Birria:2,Specials:1,Chicken:3,Wings:3,Meals:3,'Fries & Sides':4,Sides:4,Pasta:5,Salads:5,Drinks:6,Lemonades:6};
 const id=variants[category]||0;
 const base={fill:'none',stroke:'currentColor',strokeWidth:2.6,strokeLinecap:'round',strokeLinejoin:'round'};
 return <svg viewBox="0 0 150 100" className={'food-art art-'+id} aria-hidden="true"><ellipse cx="75" cy="84" rx="44" ry="5" fill="currentColor" opacity=".07"/>
 {(id===1||id===2)&&<g {...base}><path d="M39 44c1-17 15-27 36-27s35 10 36 27Z" fill="#E9C48C"/><path d="M36 52q10 8 19 0q10 8 20 0q10 8 20 0q10 8 19 0" stroke="#59835B" strokeWidth="6"/><rect x="38" y="56" width="74" height="11" rx="5" fill="#73503A"/>{id===2&&<><path d="M39 69h72l-20 7-23-4-18 5Z" fill="#D4A647"/><rect x="39" y="74" width="72" height="7" rx="3" fill="#73503A"/></>}<path d={id===2?'M40 83h70q-1 10-35 10T40 83Z':'M39 70h72q-1 12-36 12T39 70Z'} fill="#E9C48C"/><path d="m58 30 3 2m12-6 3 2m12 2 3 2" stroke="#FFF8EA" strokeWidth="3"/></g>}
 {id===3&&<g {...base} fill="#DEB67A"><rect x="41" y="27" width="24" height="53" rx="12" transform="rotate(-21 53 53)"/><rect x="64" y="24" width="24" height="54" rx="12" transform="rotate(7 76 51)"/><rect x="89" y="32" width="22" height="45" rx="11" transform="rotate(25 100 54)"/><path d="m46 42 7-3m-1 17 6-3m14-15 7 2m-8 13 6 1m22-3 5 3" stroke="#B3834F"/></g>}
 {id===4&&<g {...base}><g fill="#E6C77F"><path d="m48 54-5-31 10-2 6 32ZM62 54V16h10v38Zm16 0 5-36 10 2-5 35Zm14 3 10-30 9 3-9 31Z"/></g><path d="m40 49 12 34h47l11-34q-35 14-70 0Z" fill="#C47D5C"/><path d="M65 68h19" stroke="#F7EBDC"/></g>}
 {id===5&&<g {...base}><path d="M34 53h82q-6 29-41 29T34 53Z" fill="#FAF3E2"/><g stroke="#CAA865" strokeWidth="5"><path d="M43 49q0-18 13-9t16-5q10-15 16 3t18 11M46 46q-1-14 11-12t12-6q16-4 19 11t12 6"/></g><g fill="#C69263"><path d="m62 36 9-9 17 17-10 8Z"/><path d="m75 26 7-7 20 18-9 9Z"/></g><path d="m51 45 4-3m41 7 4-3m-29 2 3-3" stroke="#59835B"/></g>}
 {id===6&&<g {...base}><path d="m52 29 5 53h37l5-53Z" fill="#E8D388"/><path d="m54 43 3 39h37l4-39" fill="#ECDDA4" stroke="none"/><path d="m82 63 7-50h15"/><ellipse cx="75" cy="29" rx="23" ry="5"/><circle cx="98" cy="37" r="12" fill="#F1D66D"/><path d="M98 27v20m-9-14 18 9m-18 0 18-10" strokeWidth="1"/><path d="m64 52 9 2-2 9-9-2Z" fill="#FFF9E7" opacity=".8"/></g>}
 {id===0&&<g {...base}><path d="M34 55h82q-7 27-41 27T34 55Z" fill="#EED8B8"/><path d="M42 54c2-15 14-24 33-24s31 9 33 24" fill="#CD9C70"/><path d="M60 28q14-14 29-8" stroke="#5F8862"/></g>}
 </svg>;
}
