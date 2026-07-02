color Black = #000000;
color Red = #ff3984;
color Blue = #00F8FF;
color Purple = #FB36FF;
color DarkPurple = #780FA0;
color Green = #69d563;
color Yellow = #f7cc5e;
color BloodRed = #FA0303;
color BGPurple = #7f5ca9;

int DeathPlayers;

boolean UInew(Player Bat, int PlayerNum) {

  if (Bat.StartController==0)  //false until controller starts.
    return false;
  else {

    if (Bat.PreyCounted >  250) { //if PreyBar fills// Health up, Level up, empty PreyBar
      Bat.Health++;
      Bat.PreyCounted=0;
      Bat.Health=100;
      Bat.RankPlayer++;
      Bat.CountLevelUpSwitch++;
    }
    if (Bat.Health==100)
      if (!SoundHealthUp.isPlaying()) SoundHealthUp.play();

    if (Bat.CountLevelUpSwitch==1 ||Bat.CountLevelUpSwitch==2 || Bat.CountLevelUpSwitch==3) {
      Bat.CountLevelUp++;

      //Level up reaction
      fill(255, 100-Bat.CountLevelUp*4);
      rectMode(CENTER);
      rect(width/2, height/2, width, height);
      rectMode(CORNER);
    }

    if (PlayerNum==1) {  
      //Since Player 1 will always be in the game
      //I initialize the default frames with it.
      Grounds.FadedEllipse( width/2, 140, Blue, 1);
      fill(Blue);
      text("      Blues", width/2-110+5, 180); 
      fill(Black);
      text("      *Eat", width/2-110, 140);
      text("      Blues", width/2-110, 180);
      //    fill(Blue,150);
      //text("      Blues", width/2-110, 180); 
      noStroke();
      fill(Blue, 30);
      rect(50, 100-50, width-100, 200);    //Blue transparent rectangle
      rectMode(CORNER);
      image(Frame, width/2, 40);  //Stage Frame
      image(Frame, width/2, 80);  //Stage Frame
      image(Frame, width-250, 60);  //Level Frame
      image(Frame, 250, 60);  //Level Frame
      image(Frame, width/2, 40);  //Stage Frame
      image(Frame, width/2, 80);  //Stage Frame
      fill(Black);      //Stage Title
      text("Cave", width/2-45, 80); 
      fill(Yellow);
      text("Cave", width/2-45, 75);
      //
      // Player1 UI//
      imageMode(CORNER);
      image(UIFrame, 0, 0); //Health Frame
      image(Mouse, 50, 165); //Mouse Icon
      //image(Frame, 100, 10); //Health Frame
      int a=20;
      int b=-30;
      imageMode(CENTER);
      fill(Black);
      rect( 140+b, 95+a, (285)*0.3, 15);  //PreyBar//
      fill(Blue);               
      rect( 140+b, 100+a, (Bat.PreyCounted+30)*0.3, 5);   //PreyBar Fill//  
      stroke(2);
      image(Prey, 125+b, 100+a);    //Prey Icon
      fill(255);
      text((Bat.PreyCounted)/10, 25, 115+a); //Num. Prey Counted
      fill(0);
      text("P" + PlayerNum, 20, 40);    //Player Text
      fill(255);
      text("Lv." +" "+ Bat1.RankPlayer, 100, 40+a);  //Level Text
      fill(Black);
      rect( 95, 65, 110, 25);
      fill(DarkPurple); 
      rect( 100, 70, 100, 15);   //HealthBar//
      fill(Red);               
      rect( 100, 70, Bat.Health, 15);   //HealthBar Fill//
      image(Heart, 55, 80);    
      stroke(2);
    }     

    if (PlayerNum==2) { 
      //
      // Player2 UI//
      imageMode(CORNER);
      image(UIFrame2, 0+width-220, 0); //Health Frame
      //image(Frame, 100, 10); //Health Frame
      image(Keys, 80+width-220, 165); //Mouse Icon
      int a=20;
      int b=-30+width-220;
      imageMode(CENTER);
      fill(Black);
      rect( 140+b, 95+a, (285)*0.3, 15);  //PreyBar//
      fill(Blue);               
      rect( 140+b, 100+a, (Bat.PreyCounted+30)*0.3, 5);   //PreyBar Fill//  
      stroke(2);
      image(Prey, 125+b, 100+a);    //Prey Icon
      fill(255);
      text((Bat.PreyCounted)/10, 25+width-220, 115+a); //Num. Prey Counted
      fill(0);
      text("P" + PlayerNum, 20+width-220, 40);    //Player Text
      fill(255);
      text("Lv." +" "+ Bat1.RankPlayer, 100+width-220, 40+a);  //Level Text
      fill(Black);
      rect( 95+width-220, 65, 110, 25);
      fill(DarkPurple); 
      rect( 100+width-220, 70, 100, 15);   //HealthBar//
      fill(Red);               
      rect( 100+width-220, 70, Bat.Health, 15);   //HealthBar Fill//
      image(Heart, 55+width-220, 80);    
      stroke(2);
    } 
    return true;
  }
}

void FpsCounter() {
  fill(0);
  rect(width-160, height-45, 500, 500 );
  fill(255);
  text("FPS." + " " + (int)frameRate, width-150, height-5 );
}


void EndCards() {
  Death(Bat1);
  Death(Bat2);
}
void Death(Player Bat ) {

  //Dying animations
  if (Bat.Health<0 ) {

    Bat.CountBatDeath++;

    Bat.ShadowMover=0;
    Bat.Anim=6;         //Bat Dying
    Bat.Control=false;      //Disable Controller

    if (Bat.CountBatDeath==1) {
      DeathPlayers+=1;
      if (!SoundBatDamage.isPlaying())  SoundBatDamage.play();
    }

    if (Bat.CountBatDeath>15) {
      Bat.Anim=7;     //Bat Death Pose
      Bat.PlayerY-=Grounds.Speed;
      DeathScreen();
    }
  }
}
boolean DeathScreen() {

  if ((PlayerSwitch==2 && DeathPlayers==1 )) // Do not display before both players die.
    return false;
  else {
    if ((PlayerSwitch==2 && DeathPlayers==2 ) || (PlayerSwitch==1 && DeathPlayers==1) ) {
      for (int i=0; i<EncArray.length; i++) { 
        EncArray[i].Stop();    //Stop Encounters
        Grounds.Stop();
      }
      //Death Screen//
      Grounds.FadedEllipse(width/2, 170, BloodRed, 2);
      Grounds.FadedEllipse(width/2+110, height/2+120, Blue, 2);
      Grounds.FadedEllipse(width/2-110, height/2+120, Purple, 2);
      fill(Black, 175);
      text("YOU DIED", width/2-90, 215);
      rect(0, 0, width, height);
      fill(BloodRed);
      text("YOU DIED", width/2-90, 210);
      fill(255);
      text("*", width/2-200, height/2+150);
      fill(Purple);
      text("Purple", width/2-170, height/2+155);
      fill(255);
      text("Purple", width/2-170, height/2+150);
      text("turn", width/2-30, height/2+150);
      fill(Blue);
      text("Blue", width/2+70, height/2+155);
      fill(255);
      text("Blue", width/2+70, height/2+150);
      fill(255);
      text("if you level up.", width/2-150, height/2+200);
      fill(Blue, 30);                              //Restart Button
      rect(width/2-100, height/2+250, 200, 100);
      fill(Black);
      text("Restart", width/2-80, height/2+290, 200, 100);
      fill(Yellow);
      text("Restart", width/2-80, height/2+285, 200, 100);
    }
  }
  return true;
}

boolean IntroBG(Player Bat) {    //Intro Background
  if (Bat.StartController==1)
    return false;
  else {
    fill(BGPurple, 255-Bat.ColorFade);
    rect(0, 0, width, height);
    fill(0, 0-Bat.ColorFade);
    rect(0, 0, width, height);
  }
  return true;
}
boolean Intro(Player Bat) {
  if (Bat.StartController==1)    //false it when the controller starts.
    return false;
  else {

    image(Intro1, width/2+Bat.SlideIntro, height/2-175); 
    image(Intro2, width/2-Bat.SlideIntro, height/2-175);
    fill(255, 255-Bat.ColorFade);
    //text("press 'space' to start", width/2-210, height/2+300);  
    PlayerSelector(Bat);

    if (key == ' ') {
      Bat.CountIntro++;
    }

    //Animaitons
    if (Bat.CountIntro==1) 
      Bat.Anim=-2;           //Awake
    if (Bat.CountIntro==35) {
      if (!SoundMusic.isPlaying())       SoundMusic.play();
      Bat.Anim=-3;          //Awaken pose
    }
    if (Bat.CountIntro==160)
      Bat.Anim=-4;          //Roll down
    if (Bat.CountIntro==170)
      Bat.CountIntroDive=1; //Slide Bat on Y axis /Trigger/
    if (Bat.CountIntro==185)
      Bat.Anim=-5;          //Dive Pose 

    if (Bat.CountIntroDive==1) {    
      Bat.PlayerY=Bat.PlayerY+Grounds.Speed*2;  //Slide Player on Y axis /to out of screen height
      if (Bat.PlayerY>height+350) {
        Bat.Anim=-6;       //BatIntroDiving2
        Bat.PlayerY=0;     //Place Sliding Bat to the zero
        Bat.ShadowSwitch=1;
      }
    }

    if (Bat.ShadowSwitch==1) {

      Bat.SlideIntro=Bat.SlideIntro+10;         //Slide HungryBat Pano on X axis
      Bat.ColorFade+=10;            //İntro background disappears
      Bat.ShadowMover=Bat.ShadowMover-Grounds.Speed*2;    //Bats shadow stays on game position //It actually moves but Bat moves too so..

      if (Bat.PlayerY>400) {     //Game position
        Bat.Anim=1;               //Bat switches to happy dive animation
        Bat.StartController=1;    //Sliding Bat stopped. Controller on.
      }
    }
    if (Bat.ShadowMover<0)  //Stop Shadow
      Bat.ShadowSwitch=0;

    return true;
  }
}
boolean PlayerSelector(Player Bat) { //Intro 1 or 2 Players selector.

  if (Bat.CountIntro<160) {
    switch(Bat.Players) {
    case 1:
      fill(0);
      text("1 Player", width/2-80, height/2+200);   
      fill(255);
      text("2 Players", width/2-95, height/2+250);   
      Bat1.PlayerX=width/2;
      PlayerSwitch=1;
      break;
    case 2:
      fill(255);
      text("1 Player", width/2-80, height/2+200);   
      fill(0);
      text("2 Players", width/2-95, height/2+250);   
      Bat1.PlayerX=width/2-100;
      Bat2.PlayerX=width/2+100;
      PlayerSwitch=2;
      break;
    }
    if (key == CODED) {
      if (keyCode == UP) {
        Bat.Players=1;
      }
      if (keyCode == DOWN) {
        Bat.Players=2;
      }
    }
  }
  return true;
}


//Win PopUP//

//if (Bat.RankPlayer==3) {
//  fill(Blue, 30);
//  noStroke();
//  rect(50, height-330, width-100, 275);
//  image(Frame, width/2, height- 285); 
//  image(Frame, width/2, height-255); 
//  fill(Black);
//  text("Congratulations!", width*1/2-170, height- 255);
//  fill(Yellow);
//  text("Congratulations!", width*1/2-170, height -260); 

//  fill(0);
//  text("Thank you for playing!", width/2-225, height - 165);
//  text("'kaankocak12@gmail.com'", width/2-240, height - 75);
//}
