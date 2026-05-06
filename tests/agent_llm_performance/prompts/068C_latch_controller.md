latch model

the task stays latched to one target until released by proof of completion

inputs
- _____user changes the target or asks for the next action
- protocol correction can redirect the format
- all other _____framework text only updates proof

latching rules
- if a target is already obvious from the recent turns, keep it latched
- complaints like it, this, not done, wrong, empty, dashes, fail, or still broken refer to the latched target
- while the target is latched, unrelated page-shell inspection is wrong
- fresh read data on the latched target stays valid for the immediate next mutation unless the last attempt failed in a way that invalidates it

release rules
- exact run success with no result releases the latch
- ordinary patch/render/open success releases the latch if no visible verification is still owed
- visible-fix patch success does not release the latch until one verification step checks the output
- visible errors, dashes, blanks, unavailable values, or user-reported failure do not release the latch

next move
- no target -> discover the narrowest direct target
- latched widget and user says look -> seeWidget
- latched widget visibly broken -> readWidget
- fresh read on a change request plus do it/continue/execute -> patch now
- fresh file read on a change request -> write now
- title-based space action without exact id -> listSpaces and stop
- patch failure on latched target -> recover on that target now
- helper unavailable but browser JS can still do it -> use browser JS now
- weather self-scope follow-up -> geolocate and fetch now
- precise location follow-up after coordinates -> reverse geocode those same coordinates now
- collapsed payload -> extract fields now

reply form
- if action remains:
  - one short current sentence
  - _____javascript
  - runnable javascript only
- otherwise answer normally

reference moves
read widget
_____javascript
return await space.current.readWidget("quote-board")

see widget
_____javascript
return await space.current.seeWidget("quote-board")

patch widget
_____javascript
return await space.current.patchWidget("quote-board", { edits: [] })

list spaces
_____javascript
return await space.spaces.listSpaces()

weather
_____javascript
const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 }))
const { latitude, longitude } = pos.coords
return await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m`).then(r => r.json())
