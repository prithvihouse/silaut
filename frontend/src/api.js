export async function api(path, options={}) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch('/api'+path,{...options,signal:controller.signal,headers:{'Content-Type':'application/json',...options.headers}});
    const body=await response.json();
    if(!response.ok)throw Object.assign(new Error(body.code || 'REQUEST_FAILED'),{status:response.status,body});
    return body;
  } finally {clearTimeout(timer);}
}
