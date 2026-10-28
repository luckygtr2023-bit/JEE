package com.jee2028.tracker;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;
import org.json.JSONObject;
import java.util.Calendar;

public class JeeWidgetProvider extends AppWidgetProvider {
    private static final String[] MOTIVATIONS = {
        "Small steps every day build a big rank.","It’s you vs you. Win today.","Discipline today, freedom tomorrow.",
        "Chemistry is not hard — it needs the right approach.","One more question. One more chapter. One step closer to IIT.",
        "Your future self is watching. Make them proud.","Don’t stop when you’re tired. Stop when you’re done.",
        "Consistency beats talent when talent is lazy.","JEE 2028 is built by the days nobody sees.",
        "You can do it. You’re already doing it. 💪","Physics is all about the world — you are a genius in it."
    };
    static void updateAll(Context c){ AppWidgetManager m=AppWidgetManager.getInstance(c); int[] ids=m.getAppWidgetIds(new android.content.ComponentName(c,JeeWidgetProvider.class)); for(int id:ids) update(c,m,id); }
    private static void update(Context c, AppWidgetManager m, int id){
        RemoteViews v=new RemoteViews(c.getPackageName(), R.layout.jee_widget); String raw=c.getSharedPreferences("jee_widget",0).getString("data", "{}");
        try{ JSONObject d=new JSONObject(raw); long exam=d.optLong("exam",0); long days=Math.max(0,(exam-System.currentTimeMillis()+86399999L)/86400000L); v.setTextViewText(R.id.days,days+" days");
            v.setTextViewText(R.id.progress,"Today "+d.optInt("done",0)+"/11"); v.setTextViewText(R.id.streak,"🔥 "+d.optInt("streak",0)+" day streak");
            v.setTextViewText(R.id.subjects,"Phy "+d.optDouble("phy",0)+"%   Chem "+d.optDouble("chem",0)+"%   Maths "+d.optDouble("math",0)+"%");
        }catch(Exception ignored){}
        int idx=(int)((System.currentTimeMillis()/60000L)%MOTIVATIONS.length); v.setTextViewText(R.id.motivation,MOTIVATIONS[idx]); v.setTextViewText(R.id.title,"JEE 2028"); m.updateAppWidget(id,v);
    }
    @Override public void onUpdate(Context c,AppWidgetManager m,int[] ids){ for(int id:ids) update(c,m,id); }
}
