import React, {useEffect, useRef, useState} from 'react';
import {api} from './api';
import {Problem, RestaurantMark} from './workspace';

function readLogo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function toTime(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

export function Settings({profile, profileError, refreshProfile}) {
  const [form, setForm] = useState(null);
  const [file, setFile] = useState(null);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const input = useRef(null);

  useEffect(() => {
    if (profile) setForm(old => old ?? {
      name: profile.name, locationLabel: profile.locationLabel, address: profile.address ?? '',
      cutoff: toTime(profile.cutoffMinutes),
    });
  }, [profile]);

  const field = key => ({value: form[key], onChange: e => {
    setForm(old => ({...old, [key]: e.target.value}));
    setMessage('');
  }});

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem('');
    setMessage('');
    try {
      const [hours, minutes] = form.cutoff.split(':').map(Number);
      const body = {name: form.name, locationLabel: form.locationLabel, address: form.address, cutoffMinutes: hours * 60 + minutes};
      if (file) body.logo = await readLogo(file);
      else if (remove) body.logo = null;
      const updated = await api('/settings/profile', {method: 'PUT', body: JSON.stringify(body)});
      setForm({name: updated.name, locationLabel: updated.locationLabel, address: updated.address ?? '',
        cutoff: toTime(updated.cutoffMinutes)});
      setFile(null);
      setRemove(false);
      if (input.current) input.current.value = '';
      await refreshProfile();
      setMessage('Restaurant profile saved.');
    } catch (error) {
      setProblem(error.body?.code === 'INVALID_LOGO'
        ? 'Choose a valid PNG, JPEG, or WebP image up to 256 KB and 1,024 pixels per side.'
        : 'Could not save the profile. Check the fields and try again.');
    } finally { setBusy(false); }
  }

  return <main className="workspace-page settings-page">
    <div className="page-heading"><div><h1>Settings<span className="green-dot">.</span></h1>
      <p>Restaurant identity and business-day cutoff.</p></div></div>
    {profileError && !form && <Problem>Could not load restaurant settings.</Problem>}
    {!form && !profileError && <p>Loading settings…</p>}
    {form && <form className="surface settings-form" onSubmit={save}>
      <section>
        <div className="section-heading"><h2>Restaurant profile</h2>
          <p>Changes appear in the workspace and on new receipts.</p></div>
        <div className="form-grid">
          <label>Restaurant name<input required maxLength={100} {...field('name')}/></label>
          <label>Location label<input required maxLength={100} {...field('locationLabel')}/></label>
          <label className="wide">Address <span className="optional">Optional</span><input maxLength={240} {...field('address')}/></label>
        </div>
        <div className="logo-field">
          <RestaurantMark restaurant={{name: form.name || 'Bite More', logoUrl: remove ? null : profile?.logoUrl}}/>
          <div><label>Restaurant logo <span className="optional">Optional</span><input type="file" ref={input}
            accept="image/png,image/jpeg,image/webp" onChange={event => {
              const candidate = event.target.files[0] ?? null;
              if (candidate?.size > 256 * 1024) {
                event.target.value = '';
                setFile(null);
                setProblem('Logo files must be 256 KB or smaller.');
              } else {
                setFile(candidate);
                setRemove(false);
                setProblem('');
              }
              setMessage('');
            }}/></label>
            <small>PNG, JPEG, or WebP · 256 KB max · 1,024 × 1,024 max</small>
            {(profile?.logoUrl || file) && !remove && <button type="button" className="text-button" disabled={busy}
              onClick={() => {
                setFile(null);
                setRemove(Boolean(profile?.logoUrl));
                if (input.current) input.current.value = '';
                setMessage('');
              }}>Remove logo</button>}
            {remove && <small>The text mark will be used after saving.</small>}
          </div>
        </div>
      </section>
      <section className="settings-cutoff">
        <div className="section-heading"><h2>Business day</h2><p>Sales before this time count toward the preceding service date.</p></div>
        <label>Day starts at <span className="optional">Eastern time</span><input type="time" required {...field('cutoff')}/></label>
      </section>
      <Problem>{problem}</Problem>
      <div className="form-actions"><button className="primary" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save settings'}</button>
        <span role="status">{message}</span></div>
    </form>}
  </main>;
}
