import React from "@host-react";
import {createRoot} from "@host-react-dom";
window.hostReact=React;
window.renderRhineHost=(slots)=>{
 const listeners=new Set();
 window.hostChat={order:[],nodes:new Map()};
 window.hostSession={blank:true,running:false,hasMore:false,loadingOlder:false};
 window.hostEmit=()=>listeners.forEach(fn=>fn());
 const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
 const useChat=selector=>React.useSyncExternalStore(subscribe,()=>selector(window.hostChat));
 const useSession=selector=>React.useSyncExternalStore(subscribe,()=>selector(window.hostSession));
 const renderSlot=name=>slots.filter(({entry})=>entry.name===name).map(({entry,Component})=>
  React.createElement(Component,{key:entry.id,useChat,useSession,sessionId:'integration-session'}));
 const Host=()=>{
  const blank=useSession(snapshot=>snapshot.blank);
  // DSH omits header utilities until the first prompt. The composer remains
  // mounted across that transition, so controls in it keep their local state.
  return React.createElement(React.Fragment,null,
   !blank&&React.createElement('header',{key:'header','data-slot':'conversation.session.header.utilities'},
    renderSlot('conversation.session.header.utilities')),
   React.createElement('section',{key:'composer','data-slot':'conversation.input.left'},
    renderSlot('conversation.input.left')));
 };
 window.hostRoot=createRoot(document.getElementById('host'));
 window.hostRoot.render(React.createElement(Host));
};
